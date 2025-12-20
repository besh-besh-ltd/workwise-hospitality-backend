import config from "../../config/app.config.js";
import userModel from "../../models/userModel.js";
import { sendMail } from "../common.js";
import { generateEmailTemplate } from "../notificationEmailLayout.js";

export const sendGRNEmail = async (purchase_order, userList, grnRepData, day = 0) => {
  return new Promise(async (resolve, reject) => {
    try {
      const {
        id: po_id,
        rfq_id,
        po_number,
        delivery_period,
        po_approved_on,
        finalized_vendor_name,
      } = purchase_order || {};

      // Compute delivery date from po_approved_on + delivery_period (days)
      let deliveryDate = null;
      let deliveryDateLabel = "N/A";

      if (po_approved_on && delivery_period) {
        const deliveryDays = parseInt(delivery_period, 10);
        if (!Number.isNaN(deliveryDays)) {
          const base = new Date(po_approved_on);
          if (!Number.isNaN(base.getTime())) {
            deliveryDate = new Date(base.getTime());
            deliveryDate.setDate(deliveryDate.getDate() + deliveryDays);
            deliveryDateLabel = deliveryDate.toDateString();
          }
        }
      }

      // Day-specific copy
      let subjectSuffix = "GRN reminder";
      let reminderTagLine = "";
      let sequenceNote = "";

      if (day === -3) {
        subjectSuffix = "Delivery in 3 days";
        reminderTagLine = `This is a reminder that the shipment linked to PO #${po_number} is scheduled to be delivered in approximately 3 days.`;
        sequenceNote = `
          You will receive another reminder on the scheduled delivery date, 
          and one more reminder 3 days after that if the PO status is still <strong>Dispatched</strong>.
        `;
      } else if (day === 0) {
        subjectSuffix = "Scheduled delivery today";
        reminderTagLine = `Today is the scheduled delivery date for PO #${po_number}.`;
        sequenceNote = `
          If the material has already been received at site, please update the PO status to <strong>GRN</strong> in Workwise.
          You will receive one more reminder 3 days from today if the PO remains in <strong>Dispatched</strong> status.
        `;
      } else if (day === 3) {
        subjectSuffix = "Follow-up: GRN pending";
        reminderTagLine = `This is a follow-up reminder, 3 days after the scheduled delivery date for PO #${po_number}.`;
        sequenceNote = `
          If the material has been received at site, please update the PO status to <strong>GRN</strong> as soon as possible.
          If the shipment is delayed or partially delivered, kindly update the status/remarks accordingly in Workwise.
        `;
      } else {
        // Fallback / generic
        subjectSuffix = "GRN reminder";
        reminderTagLine = `This is a reminder related to Goods Received Note (GRN) for PO #${po_number}.`;
        sequenceNote = `
          If the shipment has been delivered, please update the PO status to <strong>GRN</strong> in Workwise.
        `;
      }

      const vendorName = finalized_vendor_name || "N/A";

      const headerContent = `<h2>Goods Received Note (GRN) Reminder</h2>`;

      const getContainerContent = (isGRN) => {
        return `
      <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
        <p>${reminderTagLine}</p>

        <h4>PO Details</h4>
        <ul>
          <li><strong>PO Number:</strong> ${po_number}</li>
          <li><strong>RFQ ID:</strong> ${rfq_id ?? "N/A"}</li>
          <li><strong>Vendor:</strong> ${vendorName}</li>
          <li><strong>Scheduled Delivery Date:</strong> ${deliveryDateLabel}</li>
        </ul>

        <p style="margin-top:16px;">
          This reminder is for you to verify whether the shipment has been delivered at site 
          and, if so, to update the PO status to <strong>GRN</strong> in the system.
        </p>

        <p style="margin-top:10px;">
          ${sequenceNote}
        </p>

        <div style="text-align:center; margin-top:24px;">
          ${isGRN ? (
            `<a
                href="${process.env.FRONT_END_WEBSITE}/dashboard/buyer/purchase-order/grn?rfq=${purchase_order.rfq_id}&po=${purchase_order.id}&token=${grnRepData.token}"
                style="background-color:#10B981; color:white; text-align:center; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600; margin-bottom:12px;"
            >
                Open GRN Page
            </a>`
          ) : (
            `<a href="${process.env.FRONT_END_WEBSITE}/dashboard/buyer/purchase-order?rfq_id=${rfq_id}&po=${po_id}" 
              style="background-color: #3B82F6; color: white; text-align: center; padding: 12px 24px; border-radius: 8px; text-decoration: none; display: inline-block; font-weight: 600;">
              View PO in Dashboard
            </a>`
          )}
        </div>

        <p style="text-align:center; margin-top: 30px;">
          Thank you for keeping your GRNs up to date.<br/>
          <strong>— Workwise Team</strong>
        </p>
      </div>`
      }

      const containerContent = getContainerContent(false);
      const grnContent = getContainerContent(true);

      const htmlContent = generateEmailTemplate(headerContent, containerContent);
      const grnHtmlContent = generateEmailTemplate(headerContent, grnContent);

      let recipients = {
        from: config.webmasterMail,
        subject: `GRN Reminder: PO #${po_number} – ${subjectSuffix}`,
        html: htmlContent,
      };

      let grnRecipients = {
        from: config.webmasterMail,
        subject: `GRN Reminder: PO #${po_number} – ${subjectSuffix}`,
        html: grnHtmlContent,
      };

      const emails = [];

      for (let user of userList) {
        let u = await userModel.getUserById(user);
        u = u?.[0];

        if (u && u.email) emails.push(u.email);
      }

      if(grnRepData && grnRepData.email)
        grnRecipients.to = [grnRepData.email];

      if (emails && emails.length > 0) {
        recipients.to = emails;
      } else {
        // No valid recipients, nothing to send
        return resolve(false);
      }

      sendMail(recipients);
      if(grnRepData)
        sendMail(grnRecipients);
      return resolve(true);
    } catch (err) {
      console.error("Error sending GRN reminder:", err);
      return reject(err);
    }
  });
};

export const sendInvoiceEmail = async (purchase_order, invoice_url, userList = []) => {
  return new Promise(async (resolve, reject) => {
    try {
      const {
        id: po_id,
        rfq_id,
        po_number,
        finalized_vendor_name,
        finalized_vendor_email,
      } = purchase_order || {};

      const vendorName = finalized_vendor_name || "Vendor";

      const headerContent = `<h2>Invoice Raised for Purchase Order</h2>`;

      const containerContent = `
      <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
        <p>
          This is to inform you that the vendor <strong>${vendorName}</strong> has raised and uploaded an
          invoice against the Purchase Order <strong>#${po_number}</strong>.
        </p>

        <h4>PO Details</h4>
        <ul>
          <li><strong>PO Number:</strong> ${po_number}</li>
          <li><strong>PO ID:</strong> ${po_id}</li>
          <li><strong>RFQ ID:</strong> ${rfq_id ?? "N/A"}</li>
          <li><strong>Vendor Email:</strong> ${finalized_vendor_email || "N/A"}</li>
        </ul>

        <p style="margin-top:16px;">
          This email is for your information and records that the vendor has submitted an invoice
          for this Purchase Order. Please review the invoice and process it as per your internal
          workflow.
        </p>

        <div style="text-align:center; margin-top:24px;">
          ${
            invoice_url
              ? `<a href="${invoice_url}" 
                    style="background-color:#10B981; color:white; text-align:center; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600; margin-right:12px;">
                    View Invoice
                  </a>`
              : ""
          }
          <a href="${process.env.FRONT_END_WEBSITE}/dashboard/buyer/purchase-order?rfq_id=${rfq_id}&po=${po_id}" 
             style="background-color:#3B82F6; color:white; text-align:center; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
            View PO in Dashboard
          </a>
        </div>

        <p style="text-align:center; margin-top: 30px;">
          Thank you for keeping your Purchase Orders and invoices up to date.<br/>
          <strong>— Workwise Team</strong>
        </p>
      </div>`;

      const htmlContent = generateEmailTemplate(headerContent, containerContent);

      let recipients = {
        from: config.webmasterMail,
        subject: `Invoice raised by ${vendorName} for PO #${po_number}`,
        html: htmlContent,
      };

      const emails = [];

      for (let user of userList) {
        let u = await userModel.getUserById(user);
        u = u?.[0];
        if (u && u.email) emails.push(u.email);
      }

      if (emails && emails.length > 0) {
        recipients.to = emails;
      } else {
        // fallback, no emails to send
        return resolve(false);
      }

      sendMail(recipients);
      return resolve(true);
    } catch (err) {
      console.error("Error sending invoice email:", err);
      return reject(err);
    }
  });
};
export const sendGRNUpdationEmail = async (purchase_order, grn_document_url, userList) => {
  return new Promise(async (resolve, reject) => {
    try {
      const {
        id: po_id,
        rfq_id,
        po_number,
        finalized_vendor_name,
        finalized_vendor_email,
      } = purchase_order || {};

      const vendorName = finalized_vendor_name || "Vendor";

      const headerContent = `<h2>GRN Marked for Purchase Order</h2>`;

      const containerContent = `
      <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
        <p>
          This is to inform you that <strong>GRN ( Goods Received Note )</strong> has raised and uploaded 
          against the Purchase Order <strong>#${po_number}</strong>.
        </p>

        <h4>PO Details</h4>
        <ul>
          <li><strong>PO Number:</strong> ${po_number}</li>
          <li><strong>PO ID:</strong> ${po_id}</li>
          <li><strong>RFQ ID:</strong> ${rfq_id ?? "N/A"}</li>
          <li><strong>Vendor Email:</strong> ${finalized_vendor_email || "N/A"}</li>
        </ul>

        <p style="margin-top:16px;">
          This email is for your information and records that the GRN has been marked 
          for this Purchase Order. Please review the document and process it as per your internal
          workflow.
        </p>

        <div style="text-align:center; margin-top:24px;">
          ${
            grn_document_url
              ? `<a href="${grn_document_url}" 
                    style="background-color:#10B981; color:white; text-align:center; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600; margin-right:12px;">
                    View GRN Document
                  </a>`
              : ""
          }
          <a href="${process.env.FRONT_END_WEBSITE}/dashboard/buyer/purchase-order?rfq_id=${rfq_id}&po=${po_id}" 
             style="background-color:#3B82F6; color:white; text-align:center; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
            View PO in Dashboard
          </a>
        </div>

        <p style="text-align:center; margin-top: 30px;">
          Thank you for keeping your Purchase Orders and invoices up to date.<br/>
          <strong>— Workwise Team</strong>
        </p>
      </div>`;

      const htmlContent = generateEmailTemplate(headerContent, containerContent);

      let recipients = {
        from: config.webmasterMail,
        subject: `GRN marked for PO #${po_number}`,
        html: htmlContent,
      };

      const emails = [];

      for (let user of userList) {
        let u = await userModel.getUserById(user);
        u = u?.[0];
        if (u && u.email) emails.push(u.email);
      }

      if (emails && emails.length > 0) {
        recipients.to = emails;
      } else {
        // fallback, no emails to send
        return resolve(false);
      }

      sendMail(recipients);
      return resolve(true);
    } catch (err) {
      console.error("Error sending invoice email:", err);
      return reject(err);
    }
  });
};

export const sendDispatchedEmail = async (purchase_order, userList, grnRepData) => {
  return new Promise(async (resolve, reject) => {
    try {
      const {
        id: po_id,
        rfq_id,
        po_number,
        finalized_vendor_name,
        finalized_vendor_email,
        delivery_period,
        po_approved_on,
      } = purchase_order || {};

      const vendorName = finalized_vendor_name || "Vendor";

      // Compute scheduled delivery date from po_approved_on + delivery_period (days)
      let deliveryDate = null;
      let deliveryDateLabel = "N/A";

      if (po_approved_on && delivery_period) {
        const deliveryDays = parseInt(delivery_period, 10);
        if (!Number.isNaN(deliveryDays)) {
          const base = new Date(po_approved_on);
          if (!Number.isNaN(base.getTime())) {
            deliveryDate = new Date(base.getTime());
            deliveryDate.setDate(deliveryDate.getDate() + deliveryDays);
            deliveryDateLabel = deliveryDate.toDateString();
          }
        }
      }

      const headerContent = `<h2>Dispatch Update for Purchase Order</h2>`;

      const getContainerContent = (isGRN) => `
      <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
        <p>
          This is to inform you that the vendor <strong>${vendorName}</strong> has updated the status of 
          Purchase Order <strong>#${po_number}</strong> to <strong>Dispatched</strong>. 
          The goods have left the vendor and are now on their way to the site.
        </p>

        <h4>PO Details</h4>
        <ul>
          <li><strong>PO Number:</strong> ${po_number}</li>
          <li><strong>PO ID:</strong> ${po_id}</li>
          <li><strong>RFQ ID:</strong> ${rfq_id ?? "N/A"}</li>
          <li><strong>Vendor:</strong> ${vendorName}</li>
          <li><strong>Vendor Email:</strong> ${finalized_vendor_email || "N/A"}</li>
          <li><strong>Scheduled Delivery Date (tentative):</strong> ${deliveryDateLabel}</li>
        </ul>

        <p style="margin-top:16px;">
          <strong>Action Recommended:</strong> If you have not yet assigned a site representative 
          (or store in-charge) for this delivery, please do so now. A designated site person will help ensure 
          that the Goods Received Note (GRN) is posted smoothly once the material reaches the site.
        </p>

        <p style="margin-top:10px;">
          As part of the GRN reminder workflow, you will receive automatic email reminders around the expected delivery:
        </p>
        <ul>
          <li><strong>3 days before</strong> the scheduled delivery date</li>
          <li><strong>On</strong> the scheduled delivery date</li>
          <li><strong>3 days after</strong> the scheduled delivery date (if GRN is still not posted)</li>
        </ul>

        <p style="margin-top:10px;">
          On receiving the material at site, please ensure that the PO status is updated to 
          <strong>GRN</strong> in Workwise so that records and downstream processes (like payments) remain accurate.
        </p>

        <div style="text-align:center; margin-top:24px;">
          ${isGRN ? (
            `
              <a
                  href="${process.env.FRONT_END_WEBSITE}/dashboard/buyer/purchase-order/grn?rfq=${purchase_order.rfq_id}&po=${purchase_order.id}&token=${grnRepData.token}"
                  style="background-color:#10B981; color:white; text-align:center; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600; margin-bottom:12px;"
              >
                  Open GRN Page
              </a>
            `
          ) : (
            `
              <a href="${process.env.FRONT_END_WEBSITE}/dashboard/buyer/purchase-order?rfq_id=${rfq_id}&po=${po_id}" 
                style="background-color:#3B82F6; color:white; text-align:center; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
                View PO in Dashboard
              </a>
            `
          )}
        </div>

        <p style="text-align:center; margin-top: 30px;">
          Thank you for coordinating a smooth delivery and GRN posting.<br/>
          <strong>— Workwise Team</strong>
        </p>
      </div>`

      const containerContent = getContainerContent(false);
      const grnContent = getContainerContent(true);

      const htmlContent = generateEmailTemplate(headerContent, containerContent);
      const grnHtmlContent = generateEmailTemplate(headerContent, grnContent);

      let recipients = {
        from: config.webmasterMail,
        subject: `Dispatch Update: PO #${po_number} marked as Dispatched`,
        html: htmlContent,
      };

      let grnRecipients = {
        from: config.webmasterMail,
        subject: `Dispatch Update: PO #${po_number} marked as Dispatched`,
        html: grnHtmlContent,
      };

      const emails = [];

      for (let user of userList) {
        let u = await userModel.getUserById(user);
        u = u?.[0];

        if (u && u.email) emails.push(u.email);
      }

      if (emails && emails.length > 0) {
        recipients.to = emails;
      } else {
        // no recipients -> nothing to send
        return resolve(false);
      }

      if(grnRepData && grnRepData.email)
        grnRecipients.to = [grnRepData.email]

      sendMail(recipients);
      sendMail(grnRecipients);
      return resolve(true);
    } catch (err) {
      console.error("Error sending dispatched email:", err);
      return reject(err);
    }
  });
};

export const sendGRNRepresentativeEmail = async (purchase_order, siteRepEmail, token) => {
  return new Promise(async (resolve, reject) => {
    try {
      const {
        id: po_id,
        rfq_id,
        po_number,
        finalized_vendor_name,
        finalized_vendor_email,
        delivery_period,
        po_approved_on,
      } = purchase_order || {};

      const vendorName = finalized_vendor_name || "Vendor";

      // Compute scheduled delivery date from po_approved_on + delivery_period (days)
      let deliveryDate = null;
      let deliveryDateLabel = "N/A";

      if (po_approved_on && delivery_period) {
        const deliveryDays = parseInt(delivery_period, 10);
        if (!Number.isNaN(deliveryDays)) {
          const base = new Date(po_approved_on);
          if (!Number.isNaN(base.getTime())) {
            deliveryDate = new Date(base.getTime());
            deliveryDate.setDate(deliveryDate.getDate() + deliveryDays);
            deliveryDateLabel = deliveryDate.toDateString();
          }
        }
      }

      const headerContent = `<h2>GRN Login Steps for Purchase Order</h2>`;

      const containerContent = `
        <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
            <p>
                You have been assigned as the site representative for 
                Purchase Order <strong>#${po_number}</strong>. ${purchase_order.status == 'dispatched' ? (
                    `The goods for this PO have been
                    dispatched by <strong>${vendorName}</strong> and will be delivered to your site.`
                ) : (
                    `The goods for this PO will soon be
                    dispatched by <strong>${vendorName}</strong> and will be delivered to your site.`
                )}
            </p>

            <h4>PO Details</h4>
            <ul>
                <li><strong>PO Number:</strong> ${po_number}</li>
                <li><strong>PO ID:</strong> ${po_id}</li>
                <li><strong>RFQ ID:</strong> ${rfq_id ?? "N/A"}</li>
                <li><strong>Vendor:</strong> ${vendorName}</li>
                <li><strong>Vendor Email:</strong> ${finalized_vendor_email || "N/A"}</li>
                <li><strong>Expected Delivery (tentative):</strong> ${deliveryDateLabel}</li>
            </ul>

            <p style="margin-top:16px;">
                <strong>Your responsibility:</strong> Once the material reaches the site, 
                please check the quantity and condition of the goods and update the 
                <strong>Goods Received Note (GRN)</strong> for this PO.
            </p>

            <p style="margin-top:10px;">
                You can use the secure link below to open the GRN page directly. This link is
                unique to you and is used to verify your access, so please do not share it with others.
            </p>

            <div style="text-align:center; margin-top:24px;">
                <a
                    href="${process.env.FRONT_END_WEBSITE}/dashboard/buyer/purchase-order/grn?rfq=${purchase_order.rfq_id}&po=${purchase_order.id}&token=${token}"
                    style="background-color:#10B981; color:white; text-align:center; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600; margin-bottom:12px;"
                >
                    Open GRN Page
                </a>
            </div>

            <p style="margin-top:10px;">
                You will also receive reminder emails around the expected delivery date to help you
                remember to complete the GRN once the goods arrive.
            </p>

            <p style="text-align:center; margin-top: 30px;">
                Thank you for helping keep delivery records accurate.<br/>
                <strong>— Workwise Team</strong>
            </p>
        </div>`;

      const htmlContent = generateEmailTemplate(headerContent, containerContent);

      let recipients = {
        from: config.webmasterMail,
        subject: `GRN Login Info for PO #${po_number}`,
        html: htmlContent,
      };

      const emails = [];

    //   for (let user of userList) {
    //     let u = await userModel.getUserById(user);
    //     u = u?.[0];

    //     if (u && u.email) emails.push(u.email);
    //   }

      emails.push(siteRepEmail)

      if (emails && emails.length > 0) {
        recipients.to = emails;
      } else {
        // no recipients -> nothing to send
        return resolve(false);
      }

      sendMail(recipients);
      return resolve(true);
    } catch (err) {
      console.error("Error sending dispatched email:", err);
      return reject(err);
    }
  });
};
