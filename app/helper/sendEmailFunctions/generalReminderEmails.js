import config from "../../config/app.config.js";
import userModel from "../../models/userModel.js";
import { sendMail, logError } from "../common.js";
import { emailButton, generateEmailTemplate } from "../notificationEmailLayout.js";
import { logger } from '../../util/logger.js';
import { dispatch as dispatchNotification, resolveRecipientUserIds } from "../../services/notificationService.js";
import { buyerPoDetail, buyerPoList, toAbsoluteUrl, vendorPoDetail, vendorPoList } from "../../services/notificationLinks.js";

// Root-relative for the in-app row; the email bodies wrap it with toAbsoluteUrl().
const buildPoActionUrl = (po_id) => buyerPoDetail(po_id) || buyerPoList();
const buildVendorPoActionUrl = (po_id) => vendorPoDetail(po_id) || vendorPoList();

// Callers resolve recipients with ARRAY_AGG, which returns one row holding an
// explicit NULL when no rows match — a `= []` parameter default never fires on
// that, so every entry point normalises before it iterates.
const toRecipientList = (userList) => (Array.isArray(userList) ? userList.filter(Boolean) : []);

const escapeHtml = (value) => String(value)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-24" -> "24 Oct 2026" (a calendar day: no time zone shift). */
const dayText = (day) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? ""));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : null;
};

/** "4500.00" -> "₹4,500.00". */
const amountText = (amount) => {
  if (amount == null || amount === "") return null;
  const n = Number(amount);
  return Number.isFinite(n) ? `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null;
};

/**
 * The "Invoice Details" list of the invoice-raised email: the vendor's
 * invoice number, date and amount, and the dispatch note it bills. Empty for
 * a file-only invoice (the legacy body names none of them).
 *
 * @param {{invoiceNumber?:string|null, invoiceDate?:string|null,
 *   invoiceAmount?:string|number|null, dispatchNumber?:string|null}|null} invoice
 * @returns {string} HTML ('' when there is nothing to show)
 */
export const invoiceDetailsHtml = (invoice) => {
  if (!invoice?.invoiceNumber) return "";
  const rows = [
    ["Invoice Number", invoice.invoiceNumber],
    ["Invoice Date", dayText(invoice.invoiceDate)],
    ["Invoice Amount", amountText(invoice.invoiceAmount)],
    ["Dispatch Note", invoice.dispatchNumber || null],
  ].filter(([, value]) => value != null && value !== "");
  return `
        <h4>Invoice Details</h4>
        <ul>
          ${rows.map(([label, value]) => `<li><strong>${label}:</strong> ${escapeHtml(value)}</li>`).join("\n          ")}
        </ul>`;
};

/**
 * Tells the PO's buyer team that the vendor raised an invoice.
 * @param {object} purchase_order the PO row + finalized_vendor_name/email
 * @param {string} invoice_url
 * @param {number[]} userList recipients
 * @param {object|null} [invoice] {invoiceNumber, invoiceDate, invoiceAmount,
 *   dispatchNumber} (invoiceDetailsHtml); null for a file-only invoice
 */
export const sendInvoiceEmail = async (purchase_order, invoice_url, userList = [], invoice = null) => {
  return new Promise(async (resolve, reject) => {
    try {
      const list = toRecipientList(userList);
      const {
        id: po_id,
        rfq_id,
        po_number,
        finalized_vendor_name,
        finalized_vendor_email,
      } = purchase_order || {};

      const vendorName = finalized_vendor_name || "Vendor";

      const linkPath = buildPoActionUrl(po_id);
      const emailUrl = toAbsoluteUrl(linkPath);

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
        ${invoiceDetailsHtml(invoice)}

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
          <a href="${emailUrl}"
             style="background-color:#3B82F6; color:white; text-align:center; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
            View PO in Dashboard
          </a>
        </div>

        <p style="text-align:center; margin-top: 30px;">
          Thank you for keeping your Purchase Orders and invoices up to date.<br/>
          <strong>— Phileein Hospitality Team</strong>
        </p>
      </div>`;

      const htmlContent = generateEmailTemplate(headerContent, containerContent);

      let recipients = {
        from: config.webmasterMail,
        subject: invoice?.invoiceNumber
          ? `Invoice ${invoice.invoiceNumber} raised by ${vendorName} for PO #${po_number}`
          : `Invoice raised by ${vendorName} for PO #${po_number}`,
        html: htmlContent,
      };

      const emails = [];

      for (let user of list) {
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

      try {
        const userIds = await resolveRecipientUserIds(list);
        await dispatchNotification({
          userIds,
          category: 'po',
          type: 'invoice_raised',
          title: `Invoice raised for PO #${po_number}`,
          body: `${vendorName} has submitted an invoice for your review.`,
          data: { po_id, rfq_id, invoice_url: invoice_url || null, invoice_number: invoice?.invoiceNumber || null },
          actionUrl: linkPath
        });
      } catch (notifyErr) {
        logError('dispatch invoice_raised failed', notifyErr);
      }

      return resolve(true);
    } catch (err) {
      logError("Error sending invoice email:", err);
      return reject(err);
    }
  });
};
export const sendGRNUpdationEmail = async (purchase_order, grn_document_url, userList) => {
  return new Promise(async (resolve, reject) => {
    try {
      const list = toRecipientList(userList);
      const {
        id: po_id,
        rfq_id,
        po_number,
        finalized_vendor_id,
        finalized_vendor_name,
        finalized_vendor_email,
      } = purchase_order || {};

      const vendorName = finalized_vendor_name || "Vendor";

      // The GRN is the vendor's cue to raise an invoice, so they are notified
      // too — but sent to their own PO page: a vendor account cannot open the
      // buyer dashboard, so one shared link would strand half the audience.
      const isVendor = (id) => finalized_vendor_id != null && String(id) === String(finalized_vendor_id);
      const buyerIds = list.filter((id) => !isVendor(id));
      const vendorIds = list.filter(isVendor);

      const buyerLinkPath = buildPoActionUrl(po_id);
      const vendorLinkPath = buildVendorPoActionUrl(po_id);

      const headerContent = `<h2>GRN Marked for Purchase Order</h2>`;

      const buildContainerContent = (dashboardUrl) => `
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
          <a href="${dashboardUrl}"
             style="background-color:#3B82F6; color:white; text-align:center; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
            View PO in Dashboard
          </a>
        </div>

        <p style="text-align:center; margin-top: 30px;">
          Thank you for keeping your Purchase Orders and invoices up to date.<br/>
          <strong>— Phileein Hospitality Team</strong>
        </p>
      </div>`;

      const emails = [];

      for (let user of buyerIds) {
        let u = await userModel.getUserById(user);
        u = u?.[0];
        if (u && u.email) emails.push(u.email);
      }

      const vendorNotified = vendorIds.length > 0 && !!finalized_vendor_email;

      if (emails.length === 0 && !vendorNotified) {
        // fallback, no emails to send
        return resolve(false);
      }

      if (emails.length > 0) {
        sendMail({
          from: config.webmasterMail,
          subject: `GRN marked for PO #${po_number}`,
          html: generateEmailTemplate(headerContent, buildContainerContent(toAbsoluteUrl(buyerLinkPath))),
          to: emails,
        });
      }

      if (vendorNotified) {
        sendMail({
          from: config.webmasterMail,
          subject: `GRN marked for PO #${po_number}`,
          html: generateEmailTemplate(headerContent, buildContainerContent(toAbsoluteUrl(vendorLinkPath))),
          to: finalized_vendor_email,
        });
      }

      try {
        const userIds = await resolveRecipientUserIds(buyerIds);
        await dispatchNotification({
          userIds,
          category: 'po',
          type: 'grn_marked',
          title: `GRN marked for PO #${po_number}`,
          body: `Goods Received Note has been uploaded for this Purchase Order.`,
          data: { po_id, rfq_id, grn_document_url: grn_document_url || null },
          actionUrl: buyerLinkPath
        });

        if (vendorIds.length > 0) {
          await dispatchNotification({
            userIds: await resolveRecipientUserIds(vendorIds),
            category: 'po',
            type: 'grn_marked',
            title: `GRN marked for PO #${po_number}`,
            body: `Goods have been received at site. You can now raise your invoice.`,
            data: { po_id, rfq_id, grn_document_url: grn_document_url || null },
            actionUrl: vendorLinkPath
          });
        }
      } catch (notifyErr) {
        logError('dispatch grn_marked failed', notifyErr);
      }

      return resolve(true);
    } catch (err) {
      logError("Error sending invoice email:", err);
      return reject(err);
    }
  });
};

export const sendDispatchedEmail = async (purchase_order, userList) => {
  return new Promise(async (resolve, reject) => {
    try {
      const list = toRecipientList(userList);
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

      const linkPath = buildPoActionUrl(po_id);
      const emailUrl = toAbsoluteUrl(linkPath);

      const headerContent = `<h2>Dispatch Update for Purchase Order</h2>`;

      const containerContent = `
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
          Each hotel's receiving team gets a daily reminder for deliveries that are:
        </p>
        <ul>
          <li><strong>due tomorrow</strong>,</li>
          <li><strong>due today</strong>, or</li>
          <li><strong>3 days overdue</strong> with goods still to receive.</li>
        </ul>

        <p style="margin-top:10px;">
          On receiving the material at site, please ensure that the PO status is updated to 
          <strong>GRN</strong> in Phileein Hospitality so that records and downstream processes (like payments) remain accurate.
        </p>

        <div style="text-align:center; margin-top:24px;">
          <a href="${emailUrl}"
             style="background-color:#3B82F6; color:white; text-align:center; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block; font-weight:600;">
            View PO in Dashboard
          </a>
        </div>

        <p style="text-align:center; margin-top: 30px;">
          Thank you for coordinating a smooth delivery and GRN posting.<br/>
          <strong>— Phileein Hospitality Team</strong>
        </p>
      </div>`;

      const htmlContent = generateEmailTemplate(headerContent, containerContent);

      let recipients = {
        from: config.webmasterMail,
        subject: `Dispatch Update: PO #${po_number} marked as Dispatched`,
        html: htmlContent,
      };

      const emails = [];

      for (let user of list) {
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

      sendMail(recipients);

      try {
        const userIds = await resolveRecipientUserIds(list);
        await dispatchNotification({
          userIds,
          category: 'po',
          type: 'po_dispatched',
          title: `PO #${po_number} marked as Dispatched`,
          body: `${vendorName} has dispatched the goods. Expected delivery: ${deliveryDateLabel}.`,
          data: { po_id, rfq_id, delivery_date: deliveryDate ? deliveryDate.toISOString() : null },
          actionUrl: linkPath
        });
      } catch (notifyErr) {
        logError('dispatch po_dispatched failed', notifyErr);
      }

      return resolve(true);
    } catch (err) {
      logError("Error sending dispatched email:", err);
      return reject(err);
    }
  });
};

// --- Site representative (receiving link) emails ---------------------------
//
// The receiving link carries the plain token (shown nowhere else; only its
// hash is stored). Site-rep views never show prices or buyer contacts, so
// neither does this mail.

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const IST_DATE = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });

/** "24 Oct 2026" for a Date/ISO timestamp, or a YYYY-MM-DD date as given. */
const fmtDate = (v) => {
  if (!v) return null;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split("-").map(Number);
    return IST_DATE.format(new Date(Date.UTC(y, m - 1, d, 6, 30)));
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : IST_DATE.format(d);
};

/**
 * The link the site rep opens; the page lifts the token out of the URL on load.
 * The token rides in the fragment (#t=), which the browser never sends, so it
 * stays out of frontend, proxy and load-balancer access logs. The page still
 * reads the older ?t= links already in inboxes.
 */
export const siteRepReceiveLink = (token) => toAbsoluteUrl(`/receive/token#t=${encodeURIComponent(token)}`);

/**
 * Email a site representative their receiving link.
 *
 * @param {{poNumber:string, status?:string, vendorName?:string, hotelName?:string,
 *   nextDueDate?:string|null, expiresAt:string|Date}} details
 * @param {string} siteRepEmail
 * @param {string} token  the plain token (never logged)
 * @returns {Promise<boolean>} whether the mail was handed to SMTP
 */
export const sendGRNRepresentativeEmail = async (details, siteRepEmail, token) => {
  const { poNumber, status, vendorName, hotelName, nextDueDate, expiresAt } = details || {};
  if (!siteRepEmail || !token) return false;

  const vendor = esc(vendorName || "the vendor");
  const expiry = fmtDate(expiresAt);
  const due = fmtDate(nextDueDate);

  const headerContent = `<h2>Receive goods for PO #${esc(poNumber)}</h2>`;
  const containerContent = `
    <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
      <p>
        You have been named the site representative for purchase order <strong>#${esc(poNumber)}</strong>${hotelName ? ` at <strong>${esc(hotelName)}</strong>` : ""}.
        ${status === "dispatched"
          ? `The goods have been dispatched by <strong>${vendor}</strong>.`
          : `The goods will be delivered by <strong>${vendor}</strong>.`}
      </p>
      <ul>
        <li><strong>PO number:</strong> ${esc(poNumber)}</li>
        <li><strong>Vendor:</strong> ${vendor}</li>
        ${hotelName ? `<li><strong>Deliver to:</strong> ${esc(hotelName)}</li>` : ""}
        ${due ? `<li><strong>Next delivery due:</strong> ${esc(due)}</li>` : ""}
      </ul>
      <p style="margin-top:16px;">
        When the goods arrive, open the link below, check the quantity and condition of each item,
        and record what you received.
      </p>
      <div style="text-align:center; margin-top:24px; margin-bottom:12px;">
        ${emailButton(siteRepReceiveLink(token), "Open receiving page", { bg: "#10B981" })}
      </div>
      <p style="margin-top:10px; font-size:14px; color:#555;">
        This link is personal to you; please do not forward it.
        ${expiry ? `It works until <strong>${esc(expiry)}</strong>, or until everything on the order has been received.` : ""}
        Keep this email: the delivery reminders we send you do not repeat the link. If it stops working,
        ask the buyer to send it again.
      </p>
      <p style="text-align:center; margin-top: 30px;">
        Thank you for helping keep delivery records accurate.<br/>
        <strong>— Phileein Hospitality Team</strong>
      </p>
    </div>`;

  return sendMail({
    from: config.webmasterMail,
    to: siteRepEmail,
    subject: `Receiving link for PO #${poNumber}`,
    html: generateEmailTemplate(headerContent, containerContent),
  });
};

const BUCKET_COPY = {
  due_tomorrow: "due tomorrow",
  due_today: "due today",
  overdue: "overdue",
};

/**
 * Remind a site representative of their PO's deliveries that are due tomorrow,
 * due today or 3 days overdue. Carries NO link and no token (the plain token
 * is never stored, and the buyer's login page would not let them in): it
 * points them at the link in their original email.
 *
 * @param {{to:string, name?:string, poNumber:string, hotelName?:string,
 *   expiresAt?:string|Date, deliveries:Array<{phaseNo:number, dueDate:string, bucket:string}>}} reminder
 * @returns {Promise<boolean>}
 */
export const sendSiteRepDeliveryReminderEmail = async (reminder) => {
  const { to, name, poNumber, hotelName, expiresAt, deliveries = [] } = reminder || {};
  if (!to || !deliveries.length) return false;

  const overdue = deliveries.some((d) => d.bucket === "overdue");
  const rows = deliveries
    .map((d) => `<li>Phase ${esc(d.phaseNo)}: ${esc(fmtDate(d.dueDate) || d.dueDate)} (${esc(BUCKET_COPY[d.bucket] || d.bucket)})</li>`)
    .join("");
  const expiry = fmtDate(expiresAt);

  const headerContent = `<h2>${overdue ? "Delivery overdue" : "Delivery due"}: PO #${esc(poNumber)}</h2>`;
  const containerContent = `
    <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
      <p>${name ? `Hello ${esc(name)},` : "Hello,"}</p>
      <p>
        Purchase order <strong>#${esc(poNumber)}</strong>${hotelName ? ` (${esc(hotelName)})` : ""} has deliveries to receive:
      </p>
      <ul>${rows}</ul>
      <p style="margin-top:16px;">
        When the goods arrive, record them using the receiving link in the email we sent when you were named
        site representative${expiry ? ` (it works until ${esc(expiry)})` : ""}. If you cannot find it, or it has
        stopped working, ask the buyer to send it again.
      </p>
      <p style="text-align:center; margin-top: 30px;">
        <strong>— Phileein Hospitality Team</strong>
      </p>
    </div>`;

  return sendMail({
    from: config.webmasterMail,
    to,
    subject: `${overdue ? "Overdue" : "Reminder"}: deliveries to receive for PO #${poNumber}`,
    html: generateEmailTemplate(headerContent, containerContent),
  });
};
