import db from './app/config/dbConn.js';
import Config from './app/config/app.config.js';
import { logError, sendMail, notificationMail } from './app/helper/common.js';
import { sendNotification } from './app/services/notificationService.js';
import { generateEmailTemplate } from './app/helper/notificationEmailLayout.js';
import notificationModel from './app/models/notificationModel.js';
import vendorModel from './app/models/vendorModel.js';
import Moment from 'moment';
import dateFormat from 'dateformat';
import fs from 'fs';

// Mark all expired hospitality vendor subscriptions
async function markExpiredHospitalitySubscriptions() {
  try {
    const result = await db.result(
      `UPDATE tbl_vendor_hotel_category_subscription
       SET status = 'expired'
       WHERE status = 'active'
         AND end_date < CURRENT_DATE
         AND payment_id IN (
           SELECT id FROM tbl_vendor_payments
           WHERE payment_status IN ('paid', 'success')
         )`
    );
    if (result.rowCount > 0) {
      console.log(`Marked ${result.rowCount} hospitality vendor subscriptions as expired`);
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

async function expireDayNotification(date, days) {
  let query = `SELECT tus.* ,users.user_type,users.name,users.email,users.endpoint
    FROM tbl_user_subscriptions tus
    LEFT JOIN tbl_users users ON tus.user_id = users.id
    WHERE tus.status = 1 AND end_date = '${date}'`;
  let expireSubscriptions = await db.any(query);

  for await (const expSubscriptions of expireSubscriptions) {
    let html_variables = [
      {
        name: expSubscriptions.name
      },
      {
        message:
          days != 'today'
            ? `Your subscription will expire in ${days} days`
            : `Your subscription will expire today`
      }
    ];
    let dynamic_html = fs
      .readFileSync(`${Config.template_path}/dynamic_message_template.txt`)
      .toString();

    for (let index = 0; index < html_variables.length; index++) {
      const element = html_variables[index];
      let dynamic_key = Object.keys(element)[0];
      let replace_char = html_variables[index][dynamic_key];
      let replace_var = `[${dynamic_key.toLowerCase()}]`;

      dynamic_html = dynamic_html.replaceAll(replace_var, replace_char);
    }
    let findDynamicNotification =
      await notificationModel.findDynamicNotification(
        days == 'today'
          ? 'user_subscription_expire_in_1_days'
          : days == 'seven'
          ? 'user_subscription_expire_in_7_days'
          : ''
      );

    if (
      expSubscriptions.user_type !=3 && // Exclude vendors
      findDynamicNotification.length > 0 &&
      findDynamicNotification[0].notification_type == 1
    ) {
      notificationMail({
        from: Config.webmasterMail, // sender address
        to: expSubscriptions.email, // list of receivers
        subject: findDynamicNotification[0].title, // Subject line
        html: findDynamicNotification[0].content // plain text body
      });
    }

    const spocList = await vendorModel.getSpocDetails(expSubscriptions.user_id);

    (expSubscriptions.user_type !=3) && sendMail({
      from: Config.webmasterMail, // sender address
      to: spocList?.length ? spocList.map(spoc => spoc.email) :  expSubscriptions.email, // list of receivers
      cc: spocList?.length ? expSubscriptions.email : '',
      subject: `Work Wise | Subscription Expire`, // Subject line
      // html: dynamicHTML // plain text body
      html: dynamic_html
    });

    if (expSubscriptions.endpoint) {
      const notificationData = {
        type: 'Subscription Expire Soon',
        title: `Subscription Expire Soon`,
        message:
          days != 'today'
            ? `Your subscription will expire in ${days} days`
            : `Your subscription will expire today`,
        additional_data: {
          user_type: expSubscriptions.user_type
        }
      };
      const payload = {
        title: `Hello ${expSubscriptions.name}`,
        body:
          days != 'today'
            ? `Your subscription will expire in ${days} days`
            : `Your subscription will expire today`
      };
      const ss = JSON.parse(expSubscriptions.endpoint);
      sendNotification(1, expSubscriptions.id, notificationData, payload, ss);
    }
  }
}

try {

  sendMail({
    from: Config.webmasterMail, // sender address
    to: "mukul@letsworkwise.com",
    subject: `Work Wise | Subscription Expire`, // Subject line
    // html: dynamicHTML // plain text body
    html: " Hlo mukul corntab is working take rest but dont in peace :) try block is executed "
  });

  let today = dateFormat(new Date(), 'yyyy-mm-dd');
  let query = `SELECT tus.* ,users.user_type,users.name,users.email,users.endpoint
    FROM tbl_user_subscriptions tus
    LEFT JOIN tbl_users users ON tus.user_id = users.id
    WHERE tus.status = 1 AND renew_date = '${today}'`;
  let expireSubscriptions = await db.any(query);
  for await (const expSubscriptions of expireSubscriptions) {
    let expQuery = `UPDATE tbl_user_subscriptions SET status = 3 WHERE id = ${expSubscriptions.id} 
      AND user_id = ${expSubscriptions.user_id}`;
    await db.any(expQuery);
    let updateUserTableQuery = `UPDATE tbl_users SET subscription_plan_id = ${null} WHERE 
    id = ${expSubscriptions.user_id}`;
    await db.any(updateUserTableQuery);
    let updateSubscriptionFetcherDeleteQuery = `DELETE FROM tbl_user_subscription_feature 
      WHERE user_id = ${expSubscriptions.user_id} AND user_subscriptions_id=${expSubscriptions.id} 
      AND plan_id = ${expSubscriptions.plan_id}`;
    await db.any(updateSubscriptionFetcherDeleteQuery);

    let html_variables = [
      {
        name: expSubscriptions.name
      },
      {
        message: `Your subscription plan has been expired`
      }
    ];
    let dynamic_html = fs
      .readFileSync(`${Config.template_path}/dynamic_message_template.txt`)
      .toString();

    for (let index = 0; index < html_variables.length; index++) {
      const element = html_variables[index];
      let dynamic_key = Object.keys(element)[0];
      let replace_char = html_variables[index][dynamic_key];
      let replace_var = `[${dynamic_key.toLowerCase()}]`;

      dynamic_html = dynamic_html.replaceAll(replace_var, replace_char);
    }

    const spocList = await vendorModel.getSpocDetails(expSubscriptions.user_id);

    (expSubscriptions.user_type !=3) && sendMail({
      from: Config.webmasterMail, // sender address
      to: spocList?.length ? spocList.map(spoc => spoc.email) : expSubscriptions.email, // list of receivers
      cc: spocList?.length ? expSubscriptions.email : '',
      subject: `Work Wise | Subscription Expire`, // Subject line
      // html: dynamicHTML // plain text body
      html: dynamic_html
    });

    let findDynamicNotification =
      await notificationModel.findDynamicNotification(
        'user_subscription_expired'
      );

    if (
      expSubscriptions.user_type !=3 && 
      findDynamicNotification.length > 0 &&
      findDynamicNotification[0].notification_type == 1
    ) {
      notificationMail({
        from: Config.webmasterMail, // sender address
        to: expSubscriptions.email, // list of receivers
        subject: findDynamicNotification[0].title, // Subject line
        html: findDynamicNotification[0].content // plain text body
      });
    }

    if (expSubscriptions.endpoint) {
      const notificationData = {
        type: 'Subscription Expire',
        title: `Subscription Expire`,
        message: `Subscription Expire`,
        additional_data: {
          user_type: expSubscriptions.user_type
        }
      };
      const payload = {
        title: `Hello ${expSubscriptions.name}`,
        body: `Your subscription plan has been expired`
      };
      const ss = JSON.parse(expSubscriptions.endpoint);
      sendNotification(1, expSubscriptions.id, notificationData, payload, ss);
    }
  }

  const startDate = Moment();

  //7day notification
  const sevenEndDate = startDate.clone().add(7, 'day');
  expireDayNotification(sevenEndDate.format('YYYY-MM-DD'), 'seven');
  //5day notification
  const fiveEndDate = startDate.clone().add(5, 'day');
  expireDayNotification(fiveEndDate.format('YYYY-MM-DD'), 'five');
  //4day notification
  const fourEndDate = startDate.clone().add(4, 'day');
  expireDayNotification(fourEndDate.format('YYYY-MM-DD'), 'four');
  //3day notification
  const threeEndDate = startDate.clone().add(3, 'day');
  expireDayNotification(threeEndDate.format('YYYY-MM-DD'), 'three');
  //2day notification
  const secondEndDate = startDate.clone().add(2, 'day');
  expireDayNotification(secondEndDate.format('YYYY-MM-DD'), 'two');
  //1day notification
  const oneDate = startDate.clone().add(1, 'day');
  expireDayNotification(oneDate.format('YYYY-MM-DD'), 'one');
  //today notification
  const todayDate = startDate;
  expireDayNotification(todayDate.format('YYYY-MM-DD'), 'today');

  // --- Hospitality Vendor Subscriptions ---
  // Mark expired hospitality vendor subscriptions
  markExpiredHospitalitySubscriptions();

  // Send expiry notifications to hospitality vendors (same intervals as buyer subscriptions)
  expireHospitalityVendorNotification(sevenEndDate.format('YYYY-MM-DD'), 'seven');
  expireHospitalityVendorNotification(fiveEndDate.format('YYYY-MM-DD'), 'five');
  expireHospitalityVendorNotification(fourEndDate.format('YYYY-MM-DD'), 'four');
  expireHospitalityVendorNotification(threeEndDate.format('YYYY-MM-DD'), 'three');
  expireHospitalityVendorNotification(secondEndDate.format('YYYY-MM-DD'), 'two');
  expireHospitalityVendorNotification(oneDate.format('YYYY-MM-DD'), 'one');
  expireHospitalityVendorNotification(todayDate.format('YYYY-MM-DD'), 'today');
} catch (err) {
  sendMail({
    from: Config.webmasterMail, // sender address
    to: "mukul@letsworkwise.com",
    subject: `Work Wise | Subscription Expire`, // Subject line
    // html: dynamicHTML // plain text body
    html: " Hlo mukul corntab is working take rest but dont in peace :) catch block is executed "
  });
  logError(err);
}
