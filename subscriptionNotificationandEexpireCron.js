import db from './app/config/dbConn.js';
import Config from './app/config/app.config.js';
import { logError, sendMail } from './app/helper/common.js';
import { logger } from './app/util/logger.js';
import { sendNotification } from './app/services/notificationService.js';
import { generateEmailTemplate } from './app/helper/notificationEmailLayout.js';
import Moment from 'moment';

// Mark all expired hospitality vendor subscriptions
// NOTE: We intentionally do NOT filter by payment_status here. Any row that is
// still 'active' past its end_date must transition to 'expired' so it is
// surfaced correctly in the renewal flow. Filtering by paid/success previously
// left rows with abandoned payment attempts (payment_status='created') or
// admin-assigned rows (payment_id IS NULL) stranded forever, which broke login
// for those vendors.
async function markExpiredHospitalitySubscriptions() {
  try {
    const result = await db.result(
      `UPDATE tbl_vendor_hotel_category_subscription
       SET status = 'expired'
       WHERE status = 'active'
         AND end_date < CURRENT_DATE`
    );
    if (result.rowCount > 0) {
      logger.info(`Marked ${result.rowCount} hospitality vendor subscriptions as expired`);
    }
  } catch (err) {
    logError('Error marking expired hospitality subscriptions:', err);
  }
}

// Send expiry notifications to hospitality vendors
async function expireHospitalityVendorNotification(date, days) {
  try {
    const query = `
      SELECT DISTINCT ON (vhcs.vendor_id)
        vhcs.vendor_id, vhcs.end_date,
        u.name, u.email, u.endpoint
      FROM tbl_vendor_hotel_category_subscription vhcs
      JOIN tbl_users u ON u.id = vhcs.vendor_id
      JOIN tbl_vendor_payments vp ON vp.id = vhcs.payment_id
      WHERE vhcs.status = 'active'
        AND vp.payment_status IN ('paid', 'success')
        AND vhcs.end_date = $1
      ORDER BY vhcs.vendor_id, vhcs.end_date DESC
    `;
    const expiringVendors = await db.any(query, [date]);

    for (const vendor of expiringVendors) {
      const message = days !== 'today'
        ? `Your hospitality vendor subscription will expire in ${days} days. Please renew from your dashboard.`
        : `Your hospitality vendor subscription expires today. Please renew from your dashboard to continue accessing vendor features.`;

      const emailHeader = `<h2>Dear ${vendor.name},</h2>`;
      const emailContent = `
        <p style="font-size: 16px; line-height: 1.6; color: #333;">${message}</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${process.env.FRONT_END_WEBSITE || ''}/dashboard/vendor"
             style="background-color: #158993; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: 600;">
            Renew Subscription
          </a>
        </div>
      `;
      const dynamicHTML = generateEmailTemplate(emailHeader, emailContent);

      sendMail({
        from: Config.webmasterMail,
        to: vendor.email,
        subject: `Phileein Hospitality | Subscription ${days === 'today' ? 'Expiring Today' : 'Expiry Reminder'}`,
        html: dynamicHTML
      });

      if (vendor.endpoint) {
        try {
          const notificationData = {
            type: 'Subscription Expire Soon',
            title: 'Subscription Expire Soon',
            message: message,
            additional_data: { user_type: 3 }
          };
          const payload = {
            title: `Hello ${vendor.name}`,
            body: message
          };
          const ss = JSON.parse(vendor.endpoint);
          sendNotification(1, vendor.vendor_id, notificationData, payload, ss);
        } catch (pushErr) {
          // Silently ignore push notification errors
        }
      }
    }
  } catch (err) {
    logError('Error sending hospitality vendor expiry notification:', err);
  }
}

try {
  // Heartbeat email so we know the cron actually ran today.
  sendMail({
    from: Config.webmasterMail,
    to: 'kushal@letsworkwise.com',
    subject: 'Phileein Hospitality | Subscription cron heartbeat',
    html: 'try block executed — hospitality vendor subscription expiry cron ran.'
  });

  const startDate = Moment();
  const intervals = [
    [startDate.clone().add(7, 'day'), 'seven'],
    [startDate.clone().add(5, 'day'), 'five'],
    [startDate.clone().add(4, 'day'), 'four'],
    [startDate.clone().add(3, 'day'), 'three'],
    [startDate.clone().add(2, 'day'), 'two'],
    [startDate.clone().add(1, 'day'), 'one'],
    [startDate, 'today'],
  ];

  // Mark expired hospitality vendor subscriptions
  markExpiredHospitalitySubscriptions();

  // Send expiry notifications at each interval
  for (const [date, label] of intervals) {
    expireHospitalityVendorNotification(date.format('YYYY-MM-DD'), label);
  }
} catch (err) {
  sendMail({
    from: Config.webmasterMail,
    to: 'kushal@letsworkwise.com',
    subject: 'Phileein Hospitality | Subscription cron — catch block fired',
    html: 'catch block executed — see logs for the error.'
  });
  logError(err);
}
