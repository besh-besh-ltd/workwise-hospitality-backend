import db from '../../config/dbConn.js';
import Config from '../../config/app.config.js';
import { logError, sendMail } from '../../helper/common.js';
import { generateEmailTemplate } from '../../helper/notificationEmailLayout.js';

const maintenanceController = {
  sendMaintenanceEmail: async (req, res) => {
    try {
      const { subject, message, downtime_start, downtime_end } = req.body;

      if (!subject || !message || !downtime_start || !downtime_end) {
        return res.status(400).json({
          status: 0,
          message: 'Subject, message, downtime start, and downtime end are required.'
        });
      }

      // Fetch all active buyers and vendors (user_type 2=buyer, 3=vendor, 4=vendor)
      const users = await db.any(
        `SELECT DISTINCT email, name
         FROM tbl_users
         WHERE user_type IN (2, 3, 4)
           AND is_deleted = 0
           AND status = 1
           AND email IS NOT NULL
           AND email != ''`
      );

      if (!users.length) {
        return res.status(200).json({
          status: 2,
          message: 'No active buyers or vendors found to notify.'
        });
      }

      const startDate = new Date(downtime_start);
      const endDate = new Date(downtime_end);

      const formatDateTime = (d) => {
        return d.toLocaleString('en-IN', {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: 'Asia/Kolkata'
        });
      };

      const headerContent = `
        <div style="text-align: center; margin-bottom: 16px;">
          <div style="display: inline-block; background-color: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; padding: 8px 20px;">
            <span style="font-size: 18px; font-weight: 600; color: #92400e;">Scheduled Maintenance Notice</span>
          </div>
        </div>
      `;

      const containerContent = `
        <div style="padding: 0 8px;">
          <div style="background-color: #fef9e7; border-left: 4px solid #f59e0b; padding: 16px; border-radius: 6px; margin-bottom: 20px;">
            <p style="font-size: 14px; color: #78350f; margin: 0 0 8px 0; font-weight: 600;">Downtime Window</p>
            <p style="font-size: 14px; color: #333; margin: 0;">
              <strong>From:</strong> ${formatDateTime(startDate)}<br/>
              <strong>To:</strong> ${formatDateTime(endDate)}
            </p>
          </div>
          <div style="font-size: 15px; color: #333333; line-height: 1.6;">
            ${message.replace(/\n/g, '<br/>')}
          </div>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
          <p style="font-size: 13px; color: #6b7280; margin: 0;">
            This is an automated notification from WorkWise. No action is required from your side. The platform will be back online after the maintenance window.
          </p>
        </div>
      `;

      const emailHtml = generateEmailTemplate(headerContent, containerContent);

      // Collect all email addresses
      const emailList = users.map(u => u.email);

      // Send in batches of 50 using BCC to avoid spam filters
      const BATCH_SIZE = 50;
      let sentCount = 0;
      let failedCount = 0;

      for (let i = 0; i < emailList.length; i += BATCH_SIZE) {
        const batch = emailList.slice(i, i + BATCH_SIZE);
        const result = await sendMail({
          from: Config.webmasterMail,
          to: Config.masterEmail,
          bcc: batch.join(', '),
          subject: subject,
          html: emailHtml
        });

        if (result) {
          sentCount += batch.length;
        } else {
          failedCount += batch.length;
        }
      }

      return res.status(200).json({
        status: 1,
        message: `Maintenance email sent successfully.`,
        data: {
          total_recipients: emailList.length,
          sent: sentCount,
          failed: failedCount
        }
      });
    } catch (error) {
      logError('Maintenance email error', error);
      return res.status(400).json({
        status: 3,
        message: Config.errorText.value
      });
    }
  },

  getRecipientCount: async (req, res) => {
    try {
      const result = await db.one(
        `SELECT COUNT(DISTINCT email) as count
         FROM tbl_users
         WHERE user_type IN (2, 3, 4)
           AND is_deleted = 0
           AND status = 1
           AND email IS NOT NULL
           AND email != ''`
      );

      return res.status(200).json({
        status: 1,
        data: { count: parseInt(result.count) }
      });
    } catch (error) {
      logError('Recipient count error', error);
      return res.status(400).json({
        status: 3,
        message: Config.errorText.value
      });
    }
  }
};

export default maintenanceController;
