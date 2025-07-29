import config from "../../config/app.config.js";
import userModel from "../../models/userModel.js";
import { sendMail } from "../common.js";
import { generateEmailTemplate } from "../notificationEmailLayout.js";

export const sendReminderMail = async (milestone, userList) => {
  return new Promise(async (resolve, reject) => {
    try {
      const {
        milestone_name,
        due_date,
        milestone_description,
        po_id,
        rfq_id,
      } = milestone;

      const headerContent = `<h2>📌 Upcoming Payment Milestone Reminder</h2>`;

      const containerContent = `
      <div style="font-size:16px; font-family:'Roboto', sans-serif; color:#333;">
        <p>
          This is a reminder for the following payment milestone due <strong>on ${new Date(due_date).toDateString()}</strong>.
        </p>

        <h4>Milestone Details</h4>
        <ul>
          <li><strong>Milestone Name:</strong> ${milestone_name}</li>
          <li><strong>Due Date:</strong> ${new Date(due_date).toDateString()}</li>
          <li><strong>Linked PO ID:</strong> ${po_id}</li>
          <li><strong>Linked RFQ ID:</strong> ${rfq_id}</li>
          <li><strong>Description:</strong> ${milestone_description || 'N/A'}</li>
        </ul>

        <p style="margin-top:20px; text-align:center;">
          Please ensure the necessary actions are taken on or before the due date.
        </p>

        <a href="${process.env.FRONT_END_WEBSITE}/dashboard/payment-milestones?rfq_id=${rfq_id}&po_id=${po_id}" 
           style="background-color: #3B82F6; color: white; text-align: center; padding: 12px 24px; border-radius: 8px; text-decoration: none; display: inline-block; font-weight: 600; margin: 20px auto;">
          View Milestone in Dashboard
        </a>

        <p style="text-align:center; margin-top: 30px;">
          Thank you for staying proactive.<br/>
          <strong>— Workwise Team</strong>
        </p>
      </div>`;

      const htmlContent = generateEmailTemplate(headerContent, containerContent);

      let recipients = {
        from: config.webmasterMail,
        subject: `⏰ Reminder: Milestone "${milestone_name}" is due soon`,
        html: htmlContent
      };

      const emails = userList?.map(async u => {
        const user = await userModel.getUserById(u);
        return user.email;
      }).filter(Boolean);
      
      if (emails && emails.length > 0) {
        recipients.to = emails;
      } else {
        // fallback, no emails to send
        return resolve(false);
      }

      sendMail(recipients);
      return resolve(true);

    } catch (err) {
      console.error('Error sending milestone reminder:', err);
      return reject(err);
    }
  });
};